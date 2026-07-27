/**
 * Tiny i18n layer. English is the default; the interface follows Obsidian's own
 * language setting for every locale shipped below.
 *
 * How the language is decided (in this order):
 *   1. `localStorage.getItem("language")` — where Obsidian keeps the interface
 *      language chosen in Settings -> About. It is empty/absent for English.
 *   2. `window.moment.locale()` — Obsidian ships moment on the global and keeps
 *      its locale in step with the interface language.
 *   3. English.
 *
 * Region codes are matched twice: the exact code first (`zh-TW`, `pt-BR`), then
 * the bare language (`de-AT` -> `de`). Chinese splits into Simplified (`zh`) and
 * Traditional (`zh-TW`, also `zh-Hant`/`zh-HK`); Portuguese has one table, the
 * Brazilian one, and both `pt` and `pt-BR` use it.
 *
 * Command names stay English regardless: Obsidian's own convention is that
 * command palette entries are not translated by plugins (they are user-visible
 * hotkey identifiers).
 *
 * Every table is a complete `Record<StringKey, string>`, so a missing string in
 * any language is a COMPILE error, and the unit tests walk all of them.
 */

export const LANGS = [
	"en",
	"ru",
	"zh",
	"zh-TW",
	"de",
	"fr",
	"es",
	"ja",
	"ko",
	"pt-BR",
	"it",
	"pl",
] as const;

export type Lang = (typeof LANGS)[number];

const EN = {
	/* toolbar */
	tbBold: "Bold",
	tbFontSize: "Font size",
	tbFill: "Cell fill",
	tbBorders: "Cell borders",
	tbNumberFormat: "Number format",
	tbAlign: "Alignment",
	tbWrap: "Wrap text",
	sizeDefault: "Default",
	borderAll: "All borders",
	borderOutline: "Outer borders",
	borderNone: "No borders",
	borderTop: "Top",
	borderRight: "Right",
	borderBottom: "Bottom",
	borderLeft: "Left",

	/* number formats: the mask-shaped labels are the same everywhere on purpose */
	nfAuto: "Auto",
	nfTwoDecimals: "0.00",
	nfThousands: "#,##0",
	nfThousands2: "#,##0.00",
	nfPercent: "0%",
	nfUsd: "Currency $",
	nfEur: "Currency €",
	nfRub: "Currency ₽",
	nfDate: "Date (yyyy-mm-dd)",
	nfDateTime: "Date and time",

	/* alignment */
	alignLeft: "Left",
	alignCenter: "Center",
	alignRight: "Right",
	alignTop: "Top",
	alignMiddleDefault: "Middle (default)",
	alignBottom: "Bottom",

	/* fill palette */
	fillNone: "No fill",
	fillWhite: "White",
	fillYellow: "Yellow",
	fillOrange: "Orange",
	fillRed: "Red",
	fillPink: "Pink",
	fillGreen: "Green",
	fillTeal: "Teal",
	fillBlue: "Blue",
	fillPurple: "Purple",
	fillGrey: "Grey",
	fillDark: "Dark",

	/* formula bar */
	fbPlaceholder: "Value or formula",
	fbAria: "Value or formula of the active cell",

	/* embeds */
	embedOpen: "Open the spreadsheet",
	embedMissing: "Spreadsheet Notes: no such file: {path}",
	embedBroken: "Spreadsheet Notes: could not read this spreadsheet ({message})",
	embedNoSheet: "Spreadsheet Notes: there is no worksheet named {name}",
	embedBadBlock: "Spreadsheet Notes: this block needs a path, e.g. Budget.sheet#Sheet1!A1:D20",

	/* notices */
	parseFailed: "Spreadsheet Notes: could not read this file ({message}). Opened read-only.",
	futureVersion:
		"Spreadsheet Notes: this file is version {version}, newer than the plugin understands. Opened read-only.",
	engineFailed: "Could not build the grid: {message}",
	extTaken:
		"Spreadsheet Notes: the .{ext} extension is already registered to {owner}. " +
		".{ext} stays with it; new spreadsheets will be created as .{fallback} and open in this same grid.",
	ownerUnknown: "another plugin",
	ownerNamed: 'the "{name}" plugin (view "{type}")',
	ownerViewOnly: 'the plugin whose view is "{type}"',

	/* 1.3.0: sort, filters, frozen panes, find, column width */
	tbSort: "Sort",
	tbFilter: "Filter",
	tbFreeze: "Freeze panes",
	tbFind: "Find",
	tbColWidth: "Column width",
	sortAsc: "Sort A → Z",
	sortDesc: "Sort Z → A",
	sortClear: "Clear sort",
	sortMerged: "Spreadsheet Notes: a sheet with merged cells cannot be sorted.",
	sortFormulasMoved: "Rows holding formulas were moved. Formula references were not adjusted.",
	sortNeedsCell: "Select a cell in the column you want to sort.",
	filterShowAll: "Show all",
	filterClearAll: "Clear all filters",
	filterTruncated: "Showing the first {count} values",
	filterNoValues: "This column is empty, there is nothing to filter.",
	filterHiddenRows: "{count} rows hidden by filters",
	freezeRows: "Freeze rows above the selection",
	freezeCols: "Freeze columns left of the selection",
	freezeBoth: "Freeze rows and columns",
	freezeNone: "Unfreeze",

	/* in-sheet search */
	findPlaceholder: "Find in sheet",
	findPrev: "Previous match",
	findNext: "Next match",
	findClose: "Close",
	findCount: "{index} of {total}",
	findNone: "No matches",

	/* column width dialog */
	colWidthTitle: "Column width",
	colWidthLabel: "Width in pixels",
	colWidthColumns: "Applies to: {list}",
	colWidthApply: "Apply",
	colWidthAutofit: "Fit to content",
	colWidthCancel: "Cancel",

	/* markdown interop + notices */
	mdCopied: "Copied {rows}×{cols} cells as a Markdown table",
	mdNoSelection: "Select the cells to copy first.",
	mdPasted: "Pasted a Markdown table, {rows}×{cols}",
	mdNoTable: "The clipboard does not hold a Markdown table.",
	clipboardFailed: "Could not reach the clipboard ({message})",
	sheetReadOnly: "This spreadsheet is open read-only.",
} as const;

export type StringKey = keyof typeof EN;

const RU: Record<StringKey, string> = {
	tbBold: "Жирный",
	tbFontSize: "Размер шрифта",
	tbFill: "Заливка ячейки",
	tbBorders: "Границы ячеек",
	tbNumberFormat: "Формат числа",
	tbAlign: "Выравнивание",
	tbWrap: "Переносить текст",
	sizeDefault: "По умолчанию",
	borderAll: "Все границы",
	borderOutline: "Внешние границы",
	borderNone: "Без границ",
	borderTop: "Сверху",
	borderRight: "Справа",
	borderBottom: "Снизу",
	borderLeft: "Слева",

	nfAuto: "Авто",
	nfTwoDecimals: "0.00",
	nfThousands: "#,##0",
	nfThousands2: "#,##0.00",
	nfPercent: "0%",
	nfUsd: "Валюта $",
	nfEur: "Валюта €",
	nfRub: "Валюта ₽",
	nfDate: "Дата (yyyy-mm-dd)",
	nfDateTime: "Дата и время",

	alignLeft: "По левому краю",
	alignCenter: "По центру",
	alignRight: "По правому краю",
	alignTop: "По верхнему краю",
	alignMiddleDefault: "По середине (по умолчанию)",
	alignBottom: "По нижнему краю",

	fillNone: "Без заливки",
	fillWhite: "Белый",
	fillYellow: "Жёлтый",
	fillOrange: "Оранжевый",
	fillRed: "Красный",
	fillPink: "Розовый",
	fillGreen: "Зелёный",
	fillTeal: "Бирюзовый",
	fillBlue: "Голубой",
	fillPurple: "Сиреневый",
	fillGrey: "Серый",
	fillDark: "Тёмный",

	fbPlaceholder: "Значение или формула",
	fbAria: "Значение или формула активной ячейки",

	embedOpen: "Открыть таблицу",
	embedMissing: "Spreadsheet Notes: файла нет: {path}",
	embedBroken: "Spreadsheet Notes: не удалось прочитать таблицу ({message})",
	embedNoSheet: "Spreadsheet Notes: нет листа с именем {name}",
	embedBadBlock: "Spreadsheet Notes: в блоке нужен путь, например Budget.sheet#Sheet1!A1:D20",

	parseFailed: "Spreadsheet Notes: не удалось разобрать файл ({message}). Только чтение.",
	futureVersion:
		"Spreadsheet Notes: файл версии {version} новее, чем понимает плагин. Открыт только для чтения.",
	engineFailed: "Не удалось построить таблицу: {message}",
	extTaken:
		"Spreadsheet Notes: расширение .{ext} уже занято {owner}. " +
		"Оставляем .{ext} ему; новые таблицы будут создаваться с расширением .{fallback} " +
		"и открываться в этой же сетке.",
	ownerUnknown: "другим плагином",
	ownerNamed: 'плагином «{name}» (view "{type}")',
	ownerViewOnly: 'плагином, чей view называется "{type}"',

	/* 1.3.0: sort, filters, frozen panes, find, column width */
	tbSort: "Сортировка",
	tbFilter: "Фильтр",
	tbFreeze: "Закрепить области",
	tbFind: "Поиск",
	tbColWidth: "Ширина столбца",
	sortAsc: "Сортировать А → Я",
	sortDesc: "Сортировать Я → А",
	sortClear: "Сбросить сортировку",
	sortMerged: "Spreadsheet Notes: лист с объединёнными ячейками отсортировать нельзя.",
	sortFormulasMoved: "Строки с формулами были перемещены. Ссылки в формулах не пересчитаны.",
	sortNeedsCell: "Выберите ячейку в столбце, который надо отсортировать.",
	filterShowAll: "Показать все",
	filterClearAll: "Сбросить все фильтры",
	filterTruncated: "Показаны первые {count} значений",
	filterNoValues: "Столбец пуст, фильтровать нечего.",
	filterHiddenRows: "Фильтры скрывают строк: {count}",
	freezeRows: "Закрепить строки над выделением",
	freezeCols: "Закрепить столбцы слева от выделения",
	freezeBoth: "Закрепить строки и столбцы",
	freezeNone: "Снять закрепление",

	/* in-sheet search */
	findPlaceholder: "Поиск по таблице",
	findPrev: "Предыдущее совпадение",
	findNext: "Следующее совпадение",
	findClose: "Закрыть",
	findCount: "{index} из {total}",
	findNone: "Совпадений нет",

	/* column width dialog */
	colWidthTitle: "Ширина столбца",
	colWidthLabel: "Ширина в пикселях",
	colWidthColumns: "Применить к: {list}",
	colWidthApply: "Применить",
	colWidthAutofit: "По содержимому",
	colWidthCancel: "Отмена",

	/* markdown interop + notices */
	mdCopied: "Скопировано ячеек {rows}×{cols} как таблица Markdown",
	mdNoSelection: "Сначала выделите ячейки.",
	mdPasted: "Вставлена таблица Markdown, {rows}×{cols}",
	mdNoTable: "В буфере обмена нет таблицы Markdown.",
	clipboardFailed: "Не удалось обратиться к буферу обмена ({message})",
	sheetReadOnly: "Таблица открыта только для чтения.",
};

const ZH: Record<StringKey, string> = {
	tbBold: "加粗",
	tbFontSize: "字号",
	tbFill: "单元格填充",
	tbBorders: "单元格边框",
	tbNumberFormat: "数字格式",
	tbAlign: "对齐",
	tbWrap: "自动换行",
	sizeDefault: "默认",
	borderAll: "所有边框",
	borderOutline: "外侧边框",
	borderNone: "无边框",
	borderTop: "上",
	borderRight: "右",
	borderBottom: "下",
	borderLeft: "左",

	nfAuto: "自动",
	nfTwoDecimals: "0.00",
	nfThousands: "#,##0",
	nfThousands2: "#,##0.00",
	nfPercent: "0%",
	nfUsd: "货币 $",
	nfEur: "货币 €",
	nfRub: "货币 ₽",
	nfDate: "日期（yyyy-mm-dd）",
	nfDateTime: "日期和时间",

	alignLeft: "左对齐",
	alignCenter: "居中对齐",
	alignRight: "右对齐",
	alignTop: "顶端对齐",
	alignMiddleDefault: "垂直居中（默认）",
	alignBottom: "底端对齐",

	fillNone: "无填充",
	fillWhite: "白色",
	fillYellow: "黄色",
	fillOrange: "橙色",
	fillRed: "红色",
	fillPink: "粉色",
	fillGreen: "绿色",
	fillTeal: "青色",
	fillBlue: "蓝色",
	fillPurple: "紫色",
	fillGrey: "灰色",
	fillDark: "深色",

	fbPlaceholder: "数值或公式",
	fbAria: "当前单元格的数值或公式",

	embedOpen: "打开表格",
	embedMissing: "Spreadsheet Notes：找不到文件：{path}",
	embedBroken: "Spreadsheet Notes：无法读取该表格（{message}）",
	embedNoSheet: "Spreadsheet Notes：没有名为 {name} 的工作表",
	embedBadBlock: "Spreadsheet Notes：此代码块需要文件路径，例如 Budget.sheet#Sheet1!A1:D20",

	parseFailed: "Spreadsheet Notes：无法读取此文件（{message}）。已以只读方式打开。",
	futureVersion:
		"Spreadsheet Notes：此文件为版本 {version}，高于插件所支持的版本。已以只读方式打开。",
	engineFailed: "无法创建表格：{message}",
	extTaken:
		"Spreadsheet Notes：扩展名 .{ext} 已注册给{owner}。" +
		".{ext} 仍归其所有；新表格将以 .{fallback} 创建，并在同一网格中打开。",
	ownerUnknown: "其他插件",
	ownerNamed: "插件「{name}」（view {type}）",
	ownerViewOnly: "view 名为 {type} 的插件",

	/* 1.3.0: sort, filters, frozen panes, find, column width */
	tbSort: "排序",
	tbFilter: "筛选",
	tbFreeze: "冻结窗格",
	tbFind: "查找",
	tbColWidth: "列宽",
	sortAsc: "升序排序 A → Z",
	sortDesc: "降序排序 Z → A",
	sortClear: "清除排序",
	sortMerged: "Spreadsheet Notes：含合并单元格的工作表无法排序。",
	sortFormulasMoved: "含公式的行已移动，公式引用未随之调整。",
	sortNeedsCell: "请先选择要排序的列中的单元格。",
	filterShowAll: "全部显示",
	filterClearAll: "清除所有筛选",
	filterTruncated: "仅显示前 {count} 个值",
	filterNoValues: "此列为空，没有可筛选的值。",
	filterHiddenRows: "筛选隐藏了 {count} 行",
	freezeRows: "冻结所选上方的行",
	freezeCols: "冻结所选左侧的列",
	freezeBoth: "冻结行和列",
	freezeNone: "取消冻结",

	/* in-sheet search */
	findPlaceholder: "在表格中查找",
	findPrev: "上一个匹配",
	findNext: "下一个匹配",
	findClose: "关闭",
	findCount: "第 {index} / {total} 个",
	findNone: "无匹配项",

	/* column width dialog */
	colWidthTitle: "列宽",
	colWidthLabel: "宽度（像素）",
	colWidthColumns: "应用于：{list}",
	colWidthApply: "应用",
	colWidthAutofit: "适应内容",
	colWidthCancel: "取消",

	/* markdown interop + notices */
	mdCopied: "已复制 {rows}×{cols} 个单元格为 Markdown 表格",
	mdNoSelection: "请先选择要复制的单元格。",
	mdPasted: "已粘贴 Markdown 表格，{rows}×{cols}",
	mdNoTable: "剪贴板中没有 Markdown 表格。",
	clipboardFailed: "无法访问剪贴板（{message}）",
	sheetReadOnly: "此表格以只读方式打开。",
};

const ZH_TW: Record<StringKey, string> = {
	tbBold: "粗體",
	tbFontSize: "字型大小",
	tbFill: "儲存格填滿",
	tbBorders: "儲存格框線",
	tbNumberFormat: "數字格式",
	tbAlign: "對齊",
	tbWrap: "自動換行",
	sizeDefault: "預設",
	borderAll: "所有框線",
	borderOutline: "外框線",
	borderNone: "無框線",
	borderTop: "上",
	borderRight: "右",
	borderBottom: "下",
	borderLeft: "左",

	nfAuto: "自動",
	nfTwoDecimals: "0.00",
	nfThousands: "#,##0",
	nfThousands2: "#,##0.00",
	nfPercent: "0%",
	nfUsd: "貨幣 $",
	nfEur: "貨幣 €",
	nfRub: "貨幣 ₽",
	nfDate: "日期（yyyy-mm-dd）",
	nfDateTime: "日期與時間",

	alignLeft: "靠左對齊",
	alignCenter: "置中對齊",
	alignRight: "靠右對齊",
	alignTop: "靠上對齊",
	alignMiddleDefault: "垂直置中（預設）",
	alignBottom: "靠下對齊",

	fillNone: "無填滿",
	fillWhite: "白色",
	fillYellow: "黃色",
	fillOrange: "橙色",
	fillRed: "紅色",
	fillPink: "粉紅色",
	fillGreen: "綠色",
	fillTeal: "青色",
	fillBlue: "藍色",
	fillPurple: "紫色",
	fillGrey: "灰色",
	fillDark: "深色",

	fbPlaceholder: "數值或公式",
	fbAria: "目前儲存格的數值或公式",

	embedOpen: "開啟表格",
	embedMissing: "Spreadsheet Notes：找不到檔案：{path}",
	embedBroken: "Spreadsheet Notes：無法讀取此表格（{message}）",
	embedNoSheet: "Spreadsheet Notes：沒有名為 {name} 的工作表",
	embedBadBlock: "Spreadsheet Notes：此程式碼區塊需要檔案路徑，例如 Budget.sheet#Sheet1!A1:D20",

	parseFailed: "Spreadsheet Notes：無法讀取此檔案（{message}）。已以唯讀方式開啟。",
	futureVersion:
		"Spreadsheet Notes：此檔案為版本 {version}，高於外掛所支援的版本。已以唯讀方式開啟。",
	engineFailed: "無法建立表格：{message}",
	extTaken:
		"Spreadsheet Notes：副檔名 .{ext} 已註冊給{owner}。" +
		".{ext} 仍歸其所有；新表格將以 .{fallback} 建立，並在同一個表格中開啟。",
	ownerUnknown: "其他外掛",
	ownerNamed: "外掛「{name}」（view {type}）",
	ownerViewOnly: "view 名稱為 {type} 的外掛",

	/* 1.3.0: sort, filters, frozen panes, find, column width */
	tbSort: "排序",
	tbFilter: "篩選",
	tbFreeze: "凍結窗格",
	tbFind: "尋找",
	tbColWidth: "欄寬",
	sortAsc: "遞增排序 A → Z",
	sortDesc: "遞減排序 Z → A",
	sortClear: "清除排序",
	sortMerged: "Spreadsheet Notes：含合併儲存格的工作表無法排序。",
	sortFormulasMoved: "含公式的列已移動，公式參照未隨之調整。",
	sortNeedsCell: "請先選取要排序的欄中的儲存格。",
	filterShowAll: "全部顯示",
	filterClearAll: "清除所有篩選",
	filterTruncated: "僅顯示前 {count} 個值",
	filterNoValues: "此欄為空，沒有可篩選的值。",
	filterHiddenRows: "篩選隱藏了 {count} 列",
	freezeRows: "凍結所選上方的列",
	freezeCols: "凍結所選左側的欄",
	freezeBoth: "凍結列與欄",
	freezeNone: "取消凍結",

	/* in-sheet search */
	findPlaceholder: "在表格中尋找",
	findPrev: "上一個相符項",
	findNext: "下一個相符項",
	findClose: "關閉",
	findCount: "第 {index} / {total} 個",
	findNone: "沒有相符項",

	/* column width dialog */
	colWidthTitle: "欄寬",
	colWidthLabel: "寬度（像素）",
	colWidthColumns: "套用於：{list}",
	colWidthApply: "套用",
	colWidthAutofit: "符合內容",
	colWidthCancel: "取消",

	/* markdown interop + notices */
	mdCopied: "已複製 {rows}×{cols} 個儲存格為 Markdown 表格",
	mdNoSelection: "請先選取要複製的儲存格。",
	mdPasted: "已貼上 Markdown 表格，{rows}×{cols}",
	mdNoTable: "剪貼簿中沒有 Markdown 表格。",
	clipboardFailed: "無法存取剪貼簿（{message}）",
	sheetReadOnly: "此表格以唯讀方式開啟。",
};

const DE: Record<StringKey, string> = {
	tbBold: "Fett",
	tbFontSize: "Schriftgröße",
	tbFill: "Zellenfüllung",
	tbBorders: "Zellenrahmen",
	tbNumberFormat: "Zahlenformat",
	tbAlign: "Ausrichtung",
	tbWrap: "Textumbruch",
	sizeDefault: "Standard",
	borderAll: "Alle Rahmenlinien",
	borderOutline: "Außenrahmen",
	borderNone: "Keine Rahmenlinien",
	borderTop: "Oben",
	borderRight: "Rechts",
	borderBottom: "Unten",
	borderLeft: "Links",

	nfAuto: "Automatisch",
	nfTwoDecimals: "0.00",
	nfThousands: "#,##0",
	nfThousands2: "#,##0.00",
	nfPercent: "0%",
	nfUsd: "Währung $",
	nfEur: "Währung €",
	nfRub: "Währung ₽",
	nfDate: "Datum (yyyy-mm-dd)",
	nfDateTime: "Datum und Uhrzeit",

	alignLeft: "Linksbündig",
	alignCenter: "Zentriert",
	alignRight: "Rechtsbündig",
	alignTop: "Oben",
	alignMiddleDefault: "Mittig (Standard)",
	alignBottom: "Unten",

	fillNone: "Keine Füllung",
	fillWhite: "Weiß",
	fillYellow: "Gelb",
	fillOrange: "Orange",
	fillRed: "Rot",
	fillPink: "Rosa",
	fillGreen: "Grün",
	fillTeal: "Türkis",
	fillBlue: "Blau",
	fillPurple: "Violett",
	fillGrey: "Grau",
	fillDark: "Dunkel",

	fbPlaceholder: "Wert oder Formel",
	fbAria: "Wert oder Formel der aktiven Zelle",

	embedOpen: "Tabelle öffnen",
	embedMissing: "Spreadsheet Notes: Datei nicht gefunden: {path}",
	embedBroken: "Spreadsheet Notes: Diese Tabelle konnte nicht gelesen werden ({message})",
	embedNoSheet: "Spreadsheet Notes: Es gibt kein Blatt mit dem Namen {name}",
	embedBadBlock:
		"Spreadsheet Notes: Dieser Block braucht einen Pfad, z. B. Budget.sheet#Sheet1!A1:D20",

	parseFailed:
		"Spreadsheet Notes: Diese Datei konnte nicht gelesen werden ({message}). Nur zum Lesen geöffnet.",
	futureVersion:
		"Spreadsheet Notes: Diese Datei hat Version {version} und ist neuer als das Plugin versteht. Nur zum Lesen geöffnet.",
	engineFailed: "Das Raster konnte nicht aufgebaut werden: {message}",
	extTaken:
		"Spreadsheet Notes: Die Endung .{ext} ist bereits {owner} zugeordnet. " +
		".{ext} bleibt dort; neue Tabellen werden als .{fallback} angelegt und im selben Raster geöffnet.",
	ownerUnknown: "einem anderen Plugin",
	ownerNamed: "dem Plugin „{name}“ (view „{type}“)",
	ownerViewOnly: "dem Plugin, dessen view „{type}“ heißt",

	/* 1.3.0: sort, filters, frozen panes, find, column width */
	tbSort: "Sortieren",
	tbFilter: "Filter",
	tbFreeze: "Bereiche fixieren",
	tbFind: "Suchen",
	tbColWidth: "Spaltenbreite",
	sortAsc: "Sortieren A → Z",
	sortDesc: "Sortieren Z → A",
	sortClear: "Sortierung aufheben",
	sortMerged: "Spreadsheet Notes: Ein Blatt mit verbundenen Zellen lässt sich nicht sortieren.",
	sortFormulasMoved: "Zeilen mit Formeln wurden verschoben. Die Bezüge wurden nicht angepasst.",
	sortNeedsCell: "Wähle eine Zelle in der Spalte, die sortiert werden soll.",
	filterShowAll: "Alle anzeigen",
	filterClearAll: "Alle Filter entfernen",
	filterTruncated: "Nur die ersten {count} Werte",
	filterNoValues: "Diese Spalte ist leer, es gibt nichts zu filtern.",
	filterHiddenRows: "{count} Zeilen durch Filter ausgeblendet",
	freezeRows: "Zeilen oberhalb der Auswahl fixieren",
	freezeCols: "Spalten links der Auswahl fixieren",
	freezeBoth: "Zeilen und Spalten fixieren",
	freezeNone: "Fixierung aufheben",

	/* in-sheet search */
	findPlaceholder: "Im Blatt suchen",
	findPrev: "Vorheriger Treffer",
	findNext: "Nächster Treffer",
	findClose: "Schließen",
	findCount: "{index} von {total}",
	findNone: "Keine Treffer",

	/* column width dialog */
	colWidthTitle: "Spaltenbreite",
	colWidthLabel: "Breite in Pixeln",
	colWidthColumns: "Gilt für: {list}",
	colWidthApply: "Übernehmen",
	colWidthAutofit: "An Inhalt anpassen",
	colWidthCancel: "Abbrechen",

	/* markdown interop + notices */
	mdCopied: "{rows}×{cols} Zellen als Markdown-Tabelle kopiert",
	mdNoSelection: "Zuerst die Zellen auswählen.",
	mdPasted: "Markdown-Tabelle eingefügt, {rows}×{cols}",
	mdNoTable: "In der Zwischenablage ist keine Markdown-Tabelle.",
	clipboardFailed: "Kein Zugriff auf die Zwischenablage ({message})",
	sheetReadOnly: "Diese Tabelle ist schreibgeschützt geöffnet.",
};

const FR: Record<StringKey, string> = {
	tbBold: "Gras",
	tbFontSize: "Taille de police",
	tbFill: "Remplissage de cellule",
	tbBorders: "Bordures de cellule",
	tbNumberFormat: "Format de nombre",
	tbAlign: "Alignement",
	tbWrap: "Renvoi à la ligne",
	sizeDefault: "Par défaut",
	borderAll: "Toutes les bordures",
	borderOutline: "Bordures extérieures",
	borderNone: "Aucune bordure",
	borderTop: "Haut",
	borderRight: "Droite",
	borderBottom: "Bas",
	borderLeft: "Gauche",

	nfAuto: "Auto",
	nfTwoDecimals: "0.00",
	nfThousands: "#,##0",
	nfThousands2: "#,##0.00",
	nfPercent: "0%",
	nfUsd: "Devise $",
	nfEur: "Devise €",
	nfRub: "Devise ₽",
	nfDate: "Date (yyyy-mm-dd)",
	nfDateTime: "Date et heure",

	alignLeft: "À gauche",
	alignCenter: "Au centre",
	alignRight: "À droite",
	alignTop: "En haut",
	alignMiddleDefault: "Au milieu (par défaut)",
	alignBottom: "En bas",

	fillNone: "Aucun remplissage",
	fillWhite: "Blanc",
	fillYellow: "Jaune",
	fillOrange: "Orange",
	fillRed: "Rouge",
	fillPink: "Rose",
	fillGreen: "Vert",
	fillTeal: "Turquoise",
	fillBlue: "Bleu",
	fillPurple: "Violet",
	fillGrey: "Gris",
	fillDark: "Sombre",

	fbPlaceholder: "Valeur ou formule",
	fbAria: "Valeur ou formule de la cellule active",

	embedOpen: "Ouvrir la feuille",
	embedMissing: "Spreadsheet Notes : fichier introuvable : {path}",
	embedBroken: "Spreadsheet Notes : impossible de lire cette feuille ({message})",
	embedNoSheet: "Spreadsheet Notes : aucune feuille nommée {name}",
	embedBadBlock:
		"Spreadsheet Notes : ce bloc a besoin d'un chemin, par ex. Budget.sheet#Sheet1!A1:D20",

	parseFailed:
		"Spreadsheet Notes : impossible de lire ce fichier ({message}). Ouvert en lecture seule.",
	futureVersion:
		"Spreadsheet Notes : ce fichier est en version {version}, plus récente que ce que comprend le plugin. Ouvert en lecture seule.",
	engineFailed: "Impossible de construire la grille : {message}",
	extTaken:
		"Spreadsheet Notes : l'extension .{ext} est déjà enregistrée par {owner}. " +
		".{ext} lui reste ; les nouvelles feuilles seront créées en .{fallback} et s'ouvriront dans cette même grille.",
	ownerUnknown: "un autre plugin",
	ownerNamed: "le plugin « {name} » (view « {type} »)",
	ownerViewOnly: "le plugin dont la view s'appelle « {type} »",

	/* 1.3.0: sort, filters, frozen panes, find, column width */
	tbSort: "Trier",
	tbFilter: "Filtrer",
	tbFreeze: "Figer les volets",
	tbFind: "Rechercher",
	tbColWidth: "Largeur de colonne",
	sortAsc: "Trier A → Z",
	sortDesc: "Trier Z → A",
	sortClear: "Annuler le tri",
	sortMerged: "Spreadsheet Notes : une feuille avec des cellules fusionnées ne peut pas être triée.",
	sortFormulasMoved: "Des lignes contenant des formules ont été déplacées. Les références n'ont pas été ajustées.",
	sortNeedsCell: "Sélectionnez une cellule dans la colonne à trier.",
	filterShowAll: "Tout afficher",
	filterClearAll: "Effacer tous les filtres",
	filterTruncated: "Seules les {count} premières valeurs",
	filterNoValues: "Cette colonne est vide, il n'y a rien à filtrer.",
	filterHiddenRows: "{count} lignes masquées par les filtres",
	freezeRows: "Figer les lignes au-dessus de la sélection",
	freezeCols: "Figer les colonnes à gauche de la sélection",
	freezeBoth: "Figer les lignes et les colonnes",
	freezeNone: "Libérer les volets",

	/* in-sheet search */
	findPlaceholder: "Rechercher dans la feuille",
	findPrev: "Résultat précédent",
	findNext: "Résultat suivant",
	findClose: "Fermer",
	findCount: "{index} sur {total}",
	findNone: "Aucun résultat",

	/* column width dialog */
	colWidthTitle: "Largeur de colonne",
	colWidthLabel: "Largeur en pixels",
	colWidthColumns: "S'applique à : {list}",
	colWidthApply: "Appliquer",
	colWidthAutofit: "Ajuster au contenu",
	colWidthCancel: "Annuler",

	/* markdown interop + notices */
	mdCopied: "{rows}×{cols} cellules copiées en tableau Markdown",
	mdNoSelection: "Sélectionnez d'abord les cellules à copier.",
	mdPasted: "Tableau Markdown collé, {rows}×{cols}",
	mdNoTable: "Le presse-papiers ne contient pas de tableau Markdown.",
	clipboardFailed: "Accès au presse-papiers impossible ({message})",
	sheetReadOnly: "Cette feuille est ouverte en lecture seule.",
};

const ES: Record<StringKey, string> = {
	tbBold: "Negrita",
	tbFontSize: "Tamaño de fuente",
	tbFill: "Relleno de celda",
	tbBorders: "Bordes de celda",
	tbNumberFormat: "Formato de número",
	tbAlign: "Alineación",
	tbWrap: "Ajustar texto",
	sizeDefault: "Predeterminado",
	borderAll: "Todos los bordes",
	borderOutline: "Bordes exteriores",
	borderNone: "Sin bordes",
	borderTop: "Arriba",
	borderRight: "Derecha",
	borderBottom: "Abajo",
	borderLeft: "Izquierda",

	nfAuto: "Automático",
	nfTwoDecimals: "0.00",
	nfThousands: "#,##0",
	nfThousands2: "#,##0.00",
	nfPercent: "0%",
	nfUsd: "Moneda $",
	nfEur: "Moneda €",
	nfRub: "Moneda ₽",
	nfDate: "Fecha (yyyy-mm-dd)",
	nfDateTime: "Fecha y hora",

	alignLeft: "Izquierda",
	alignCenter: "Centro",
	alignRight: "Derecha",
	alignTop: "Arriba",
	alignMiddleDefault: "Centro vertical (predeterminado)",
	alignBottom: "Abajo",

	fillNone: "Sin relleno",
	fillWhite: "Blanco",
	fillYellow: "Amarillo",
	fillOrange: "Naranja",
	fillRed: "Rojo",
	fillPink: "Rosa",
	fillGreen: "Verde",
	fillTeal: "Turquesa",
	fillBlue: "Azul",
	fillPurple: "Morado",
	fillGrey: "Gris",
	fillDark: "Oscuro",

	fbPlaceholder: "Valor o fórmula",
	fbAria: "Valor o fórmula de la celda activa",

	embedOpen: "Abrir la hoja",
	embedMissing: "Spreadsheet Notes: no se encuentra el archivo: {path}",
	embedBroken: "Spreadsheet Notes: no se pudo leer esta hoja ({message})",
	embedNoSheet: "Spreadsheet Notes: no hay ninguna hoja llamada {name}",
	embedBadBlock:
		"Spreadsheet Notes: este bloque necesita una ruta, p. ej. Budget.sheet#Sheet1!A1:D20",

	parseFailed:
		"Spreadsheet Notes: no se pudo leer este archivo ({message}). Abierto solo para lectura.",
	futureVersion:
		"Spreadsheet Notes: este archivo es de la versión {version}, más nueva de lo que entiende el plugin. Abierto solo para lectura.",
	engineFailed: "No se pudo construir la cuadrícula: {message}",
	extTaken:
		"Spreadsheet Notes: la extensión .{ext} ya está registrada por {owner}. " +
		".{ext} se queda con él; las hojas nuevas se crearán como .{fallback} y se abrirán en esta misma cuadrícula.",
	ownerUnknown: "otro plugin",
	ownerNamed: "el plugin «{name}» (view «{type}»)",
	ownerViewOnly: "el plugin cuya view se llama «{type}»",

	/* 1.3.0: sort, filters, frozen panes, find, column width */
	tbSort: "Ordenar",
	tbFilter: "Filtrar",
	tbFreeze: "Inmovilizar paneles",
	tbFind: "Buscar",
	tbColWidth: "Ancho de columna",
	sortAsc: "Ordenar A → Z",
	sortDesc: "Ordenar Z → A",
	sortClear: "Quitar el orden",
	sortMerged: "Spreadsheet Notes: una hoja con celdas combinadas no se puede ordenar.",
	sortFormulasMoved: "Se han movido filas con fórmulas. Las referencias no se han ajustado.",
	sortNeedsCell: "Selecciona una celda de la columna que quieras ordenar.",
	filterShowAll: "Mostrar todo",
	filterClearAll: "Quitar todos los filtros",
	filterTruncated: "Solo los primeros {count} valores",
	filterNoValues: "Esta columna está vacía, no hay nada que filtrar.",
	filterHiddenRows: "{count} filas ocultas por los filtros",
	freezeRows: "Inmovilizar las filas por encima de la selección",
	freezeCols: "Inmovilizar las columnas a la izquierda de la selección",
	freezeBoth: "Inmovilizar filas y columnas",
	freezeNone: "Movilizar paneles",

	/* in-sheet search */
	findPlaceholder: "Buscar en la hoja",
	findPrev: "Coincidencia anterior",
	findNext: "Coincidencia siguiente",
	findClose: "Cerrar",
	findCount: "{index} de {total}",
	findNone: "Sin coincidencias",

	/* column width dialog */
	colWidthTitle: "Ancho de columna",
	colWidthLabel: "Ancho en píxeles",
	colWidthColumns: "Se aplica a: {list}",
	colWidthApply: "Aplicar",
	colWidthAutofit: "Ajustar al contenido",
	colWidthCancel: "Cancelar",

	/* markdown interop + notices */
	mdCopied: "{rows}×{cols} celdas copiadas como tabla Markdown",
	mdNoSelection: "Selecciona primero las celdas que quieras copiar.",
	mdPasted: "Tabla Markdown pegada, {rows}×{cols}",
	mdNoTable: "El portapapeles no contiene una tabla Markdown.",
	clipboardFailed: "No se pudo acceder al portapapeles ({message})",
	sheetReadOnly: "Esta hoja está abierta en modo de solo lectura.",
};

const JA: Record<StringKey, string> = {
	tbBold: "太字",
	tbFontSize: "フォントサイズ",
	tbFill: "セルの塗りつぶし",
	tbBorders: "セルの罫線",
	tbNumberFormat: "表示形式",
	tbAlign: "配置",
	tbWrap: "折り返して全体を表示",
	sizeDefault: "既定",
	borderAll: "格子",
	borderOutline: "外枠",
	borderNone: "枠なし",
	borderTop: "上",
	borderRight: "右",
	borderBottom: "下",
	borderLeft: "左",

	nfAuto: "自動",
	nfTwoDecimals: "0.00",
	nfThousands: "#,##0",
	nfThousands2: "#,##0.00",
	nfPercent: "0%",
	nfUsd: "通貨 $",
	nfEur: "通貨 €",
	nfRub: "通貨 ₽",
	nfDate: "日付（yyyy-mm-dd）",
	nfDateTime: "日付と時刻",

	alignLeft: "左揃え",
	alignCenter: "中央揃え",
	alignRight: "右揃え",
	alignTop: "上揃え",
	alignMiddleDefault: "上下中央（既定）",
	alignBottom: "下揃え",

	fillNone: "塗りつぶしなし",
	fillWhite: "白",
	fillYellow: "黄",
	fillOrange: "オレンジ",
	fillRed: "赤",
	fillPink: "ピンク",
	fillGreen: "緑",
	fillTeal: "青緑",
	fillBlue: "青",
	fillPurple: "紫",
	fillGrey: "グレー",
	fillDark: "濃色",

	fbPlaceholder: "値または数式",
	fbAria: "アクティブなセルの値または数式",

	embedOpen: "表を開く",
	embedMissing: "Spreadsheet Notes: ファイルが見つかりません: {path}",
	embedBroken: "Spreadsheet Notes: この表を読み込めませんでした（{message}）",
	embedNoSheet: "Spreadsheet Notes: 「{name}」という名前のシートがありません",
	embedBadBlock:
		"Spreadsheet Notes: このブロックにはパスが必要です。例: Budget.sheet#Sheet1!A1:D20",

	parseFailed:
		"Spreadsheet Notes: このファイルを読み込めませんでした（{message}）。読み取り専用で開きました。",
	futureVersion:
		"Spreadsheet Notes: このファイルはバージョン {version} で、プラグインが理解できる版より新しいです。読み取り専用で開きました。",
	engineFailed: "表を作成できませんでした: {message}",
	extTaken:
		"Spreadsheet Notes: 拡張子 .{ext} はすでに{owner}に登録されています。" +
		".{ext} はそのままにし、新しい表は .{fallback} として作成され、同じ表で開きます。",
	ownerUnknown: "他のプラグイン",
	ownerNamed: "プラグイン「{name}」（view「{type}」）",
	ownerViewOnly: "view が「{type}」のプラグイン",

	/* 1.3.0: sort, filters, frozen panes, find, column width */
	tbSort: "並べ替え",
	tbFilter: "フィルタ",
	tbFreeze: "ウィンドウ枠の固定",
	tbFind: "検索",
	tbColWidth: "列の幅",
	sortAsc: "昇順に並べ替え A → Z",
	sortDesc: "降順に並べ替え Z → A",
	sortClear: "並べ替えを解除",
	sortMerged: "Spreadsheet Notes: 結合セルのあるシートは並べ替えできません。",
	sortFormulasMoved: "数式のある行を移動しました。数式の参照は調整されていません。",
	sortNeedsCell: "並べ替える列のセルを選択してください。",
	filterShowAll: "すべて表示",
	filterClearAll: "すべてのフィルタを解除",
	filterTruncated: "先頭の {count} 件のみ表示",
	filterNoValues: "この列は空で、フィルタする値がありません。",
	filterHiddenRows: "フィルタで {count} 行を非表示",
	freezeRows: "選択範囲より上の行を固定",
	freezeCols: "選択範囲より左の列を固定",
	freezeBoth: "行と列を固定",
	freezeNone: "固定を解除",

	/* in-sheet search */
	findPlaceholder: "シート内を検索",
	findPrev: "前の一致",
	findNext: "次の一致",
	findClose: "閉じる",
	findCount: "{index} / {total}",
	findNone: "一致なし",

	/* column width dialog */
	colWidthTitle: "列の幅",
	colWidthLabel: "幅（ピクセル）",
	colWidthColumns: "適用先: {list}",
	colWidthApply: "適用",
	colWidthAutofit: "内容に合わせる",
	colWidthCancel: "キャンセル",

	/* markdown interop + notices */
	mdCopied: "{rows}×{cols} セルを Markdown の表としてコピーしました",
	mdNoSelection: "先にコピーするセルを選択してください。",
	mdPasted: "Markdown の表を貼り付けました（{rows}×{cols}）",
	mdNoTable: "クリップボードに Markdown の表がありません。",
	clipboardFailed: "クリップボードにアクセスできません（{message}）",
	sheetReadOnly: "このシートは読み取り専用で開いています。",
};

const KO: Record<StringKey, string> = {
	tbBold: "굵게",
	tbFontSize: "글꼴 크기",
	tbFill: "셀 채우기",
	tbBorders: "셀 테두리",
	tbNumberFormat: "숫자 서식",
	tbAlign: "정렬",
	tbWrap: "자동 줄 바꿈",
	sizeDefault: "기본값",
	borderAll: "모든 테두리",
	borderOutline: "바깥쪽 테두리",
	borderNone: "테두리 없음",
	borderTop: "위",
	borderRight: "오른쪽",
	borderBottom: "아래",
	borderLeft: "왼쪽",

	nfAuto: "자동",
	nfTwoDecimals: "0.00",
	nfThousands: "#,##0",
	nfThousands2: "#,##0.00",
	nfPercent: "0%",
	nfUsd: "통화 $",
	nfEur: "통화 €",
	nfRub: "통화 ₽",
	nfDate: "날짜(yyyy-mm-dd)",
	nfDateTime: "날짜 및 시간",

	alignLeft: "왼쪽 정렬",
	alignCenter: "가운데 정렬",
	alignRight: "오른쪽 정렬",
	alignTop: "위쪽 정렬",
	alignMiddleDefault: "세로 가운데(기본값)",
	alignBottom: "아래쪽 정렬",

	fillNone: "채우기 없음",
	fillWhite: "흰색",
	fillYellow: "노란색",
	fillOrange: "주황색",
	fillRed: "빨간색",
	fillPink: "분홍색",
	fillGreen: "초록색",
	fillTeal: "청록색",
	fillBlue: "파란색",
	fillPurple: "보라색",
	fillGrey: "회색",
	fillDark: "어두운색",

	fbPlaceholder: "값 또는 수식",
	fbAria: "활성 셀의 값 또는 수식",

	embedOpen: "시트 열기",
	embedMissing: "Spreadsheet Notes: 파일을 찾을 수 없습니다: {path}",
	embedBroken: "Spreadsheet Notes: 이 시트를 읽을 수 없습니다({message})",
	embedNoSheet: "Spreadsheet Notes: '{name}' 시트가 없습니다",
	embedBadBlock: "Spreadsheet Notes: 이 블록에는 경로가 필요합니다. 예: Budget.sheet#Sheet1!A1:D20",

	parseFailed: "Spreadsheet Notes: 이 파일을 읽을 수 없습니다({message}). 읽기 전용으로 열었습니다.",
	futureVersion:
		"Spreadsheet Notes: 이 파일은 버전 {version}으로 플러그인이 이해하는 버전보다 최신입니다. 읽기 전용으로 열었습니다.",
	engineFailed: "표를 만들 수 없습니다: {message}",
	extTaken:
		"Spreadsheet Notes: 확장자 .{ext}는 이미 {owner}에 등록되어 있습니다. " +
		".{ext}는 그대로 두고, 새 시트는 .{fallback}로 만들어 같은 표에서 엽니다.",
	ownerUnknown: "다른 플러그인",
	ownerNamed: "플러그인 '{name}'(view '{type}')",
	ownerViewOnly: "view 이름이 '{type}'인 플러그인",

	/* 1.3.0: sort, filters, frozen panes, find, column width */
	tbSort: "정렬",
	tbFilter: "필터",
	tbFreeze: "틀 고정",
	tbFind: "찾기",
	tbColWidth: "열 너비",
	sortAsc: "오름차순 정렬 A → Z",
	sortDesc: "내림차순 정렬 Z → A",
	sortClear: "정렬 해제",
	sortMerged: "Spreadsheet Notes: 병합된 셀이 있는 시트는 정렬할 수 없습니다.",
	sortFormulasMoved: "수식이 있는 행이 이동했습니다. 수식 참조는 조정되지 않았습니다.",
	sortNeedsCell: "정렬할 열의 셀을 선택하세요.",
	filterShowAll: "모두 표시",
	filterClearAll: "모든 필터 해제",
	filterTruncated: "처음 {count}개 값만 표시",
	filterNoValues: "이 열은 비어 있어 필터할 값이 없습니다.",
	filterHiddenRows: "필터로 {count}개 행 숨김",
	freezeRows: "선택 위쪽 행 고정",
	freezeCols: "선택 왼쪽 열 고정",
	freezeBoth: "행과 열 고정",
	freezeNone: "고정 해제",

	/* in-sheet search */
	findPlaceholder: "시트에서 찾기",
	findPrev: "이전 일치",
	findNext: "다음 일치",
	findClose: "닫기",
	findCount: "{index} / {total}",
	findNone: "일치 항목 없음",

	/* column width dialog */
	colWidthTitle: "열 너비",
	colWidthLabel: "너비(픽셀)",
	colWidthColumns: "적용 대상: {list}",
	colWidthApply: "적용",
	colWidthAutofit: "내용에 맞추기",
	colWidthCancel: "취소",

	/* markdown interop + notices */
	mdCopied: "{rows}×{cols} 셀을 Markdown 표로 복사했습니다",
	mdNoSelection: "복사할 셀을 먼저 선택하세요.",
	mdPasted: "Markdown 표를 붙여넣었습니다({rows}×{cols})",
	mdNoTable: "클립보드에 Markdown 표가 없습니다.",
	clipboardFailed: "클립보드에 접근할 수 없습니다({message})",
	sheetReadOnly: "이 시트는 읽기 전용으로 열렸습니다.",
};

const PT_BR: Record<StringKey, string> = {
	tbBold: "Negrito",
	tbFontSize: "Tamanho da fonte",
	tbFill: "Preenchimento da célula",
	tbBorders: "Bordas da célula",
	tbNumberFormat: "Formato de número",
	tbAlign: "Alinhamento",
	tbWrap: "Quebrar texto",
	sizeDefault: "Padrão",
	borderAll: "Todas as bordas",
	borderOutline: "Bordas externas",
	borderNone: "Sem bordas",
	borderTop: "Superior",
	borderRight: "Direita",
	borderBottom: "Inferior",
	borderLeft: "Esquerda",

	nfAuto: "Automático",
	nfTwoDecimals: "0.00",
	nfThousands: "#,##0",
	nfThousands2: "#,##0.00",
	nfPercent: "0%",
	nfUsd: "Moeda $",
	nfEur: "Moeda €",
	nfRub: "Moeda ₽",
	nfDate: "Data (yyyy-mm-dd)",
	nfDateTime: "Data e hora",

	alignLeft: "À esquerda",
	alignCenter: "Centralizado",
	alignRight: "À direita",
	alignTop: "Em cima",
	alignMiddleDefault: "No meio (padrão)",
	alignBottom: "Embaixo",

	fillNone: "Sem preenchimento",
	fillWhite: "Branco",
	fillYellow: "Amarelo",
	fillOrange: "Laranja",
	fillRed: "Vermelho",
	fillPink: "Rosa",
	fillGreen: "Verde",
	fillTeal: "Turquesa",
	fillBlue: "Azul",
	fillPurple: "Roxo",
	fillGrey: "Cinza",
	fillDark: "Escuro",

	fbPlaceholder: "Valor ou fórmula",
	fbAria: "Valor ou fórmula da célula ativa",

	embedOpen: "Abrir a planilha",
	embedMissing: "Spreadsheet Notes: arquivo não encontrado: {path}",
	embedBroken: "Spreadsheet Notes: não foi possível ler esta planilha ({message})",
	embedNoSheet: "Spreadsheet Notes: não existe planilha chamada {name}",
	embedBadBlock:
		"Spreadsheet Notes: este bloco precisa de um caminho, por ex. Budget.sheet#Sheet1!A1:D20",

	parseFailed:
		"Spreadsheet Notes: não foi possível ler este arquivo ({message}). Aberto somente para leitura.",
	futureVersion:
		"Spreadsheet Notes: este arquivo é da versão {version}, mais nova do que o plugin entende. Aberto somente para leitura.",
	engineFailed: "Não foi possível montar a grade: {message}",
	extTaken:
		"Spreadsheet Notes: a extensão .{ext} já está registrada para {owner}. " +
		".{ext} fica com ele; novas planilhas serão criadas como .{fallback} e abrirão nesta mesma grade.",
	ownerUnknown: "outro plugin",
	ownerNamed: "o plugin «{name}» (view «{type}»)",
	ownerViewOnly: "o plugin cuja view se chama «{type}»",

	/* 1.3.0: sort, filters, frozen panes, find, column width */
	tbSort: "Classificar",
	tbFilter: "Filtrar",
	tbFreeze: "Congelar painéis",
	tbFind: "Localizar",
	tbColWidth: "Largura da coluna",
	sortAsc: "Classificar A → Z",
	sortDesc: "Classificar Z → A",
	sortClear: "Remover a classificação",
	sortMerged: "Spreadsheet Notes: uma planilha com células mescladas não pode ser classificada.",
	sortFormulasMoved: "Linhas com fórmulas foram movidas. As referências não foram ajustadas.",
	sortNeedsCell: "Selecione uma célula da coluna que deseja classificar.",
	filterShowAll: "Mostrar tudo",
	filterClearAll: "Limpar todos os filtros",
	filterTruncated: "Apenas os primeiros {count} valores",
	filterNoValues: "Esta coluna está vazia, não há o que filtrar.",
	filterHiddenRows: "{count} linhas ocultas pelos filtros",
	freezeRows: "Congelar as linhas acima da seleção",
	freezeCols: "Congelar as colunas à esquerda da seleção",
	freezeBoth: "Congelar linhas e colunas",
	freezeNone: "Descongelar",

	/* in-sheet search */
	findPlaceholder: "Localizar na planilha",
	findPrev: "Ocorrência anterior",
	findNext: "Próxima ocorrência",
	findClose: "Fechar",
	findCount: "{index} de {total}",
	findNone: "Nenhuma ocorrência",

	/* column width dialog */
	colWidthTitle: "Largura da coluna",
	colWidthLabel: "Largura em pixels",
	colWidthColumns: "Aplica-se a: {list}",
	colWidthApply: "Aplicar",
	colWidthAutofit: "Ajustar ao conteúdo",
	colWidthCancel: "Cancelar",

	/* markdown interop + notices */
	mdCopied: "{rows}×{cols} células copiadas como tabela Markdown",
	mdNoSelection: "Selecione primeiro as células a copiar.",
	mdPasted: "Tabela Markdown colada, {rows}×{cols}",
	mdNoTable: "A área de transferência não contém uma tabela Markdown.",
	clipboardFailed: "Não foi possível acessar a área de transferência ({message})",
	sheetReadOnly: "Esta planilha está aberta somente para leitura.",
};

const IT: Record<StringKey, string> = {
	tbBold: "Grassetto",
	tbFontSize: "Dimensione carattere",
	tbFill: "Riempimento cella",
	tbBorders: "Bordi cella",
	tbNumberFormat: "Formato numero",
	tbAlign: "Allineamento",
	tbWrap: "Testo a capo",
	sizeDefault: "Predefinito",
	borderAll: "Tutti i bordi",
	borderOutline: "Bordi esterni",
	borderNone: "Nessun bordo",
	borderTop: "In alto",
	borderRight: "A destra",
	borderBottom: "In basso",
	borderLeft: "A sinistra",

	nfAuto: "Auto",
	nfTwoDecimals: "0.00",
	nfThousands: "#,##0",
	nfThousands2: "#,##0.00",
	nfPercent: "0%",
	nfUsd: "Valuta $",
	nfEur: "Valuta €",
	nfRub: "Valuta ₽",
	nfDate: "Data (yyyy-mm-dd)",
	nfDateTime: "Data e ora",

	alignLeft: "A sinistra",
	alignCenter: "Al centro",
	alignRight: "A destra",
	alignTop: "In alto",
	alignMiddleDefault: "Al centro (predefinito)",
	alignBottom: "In basso",

	fillNone: "Nessun riempimento",
	fillWhite: "Bianco",
	fillYellow: "Giallo",
	fillOrange: "Arancione",
	fillRed: "Rosso",
	fillPink: "Rosa",
	fillGreen: "Verde",
	fillTeal: "Turchese",
	fillBlue: "Azzurro",
	fillPurple: "Viola",
	fillGrey: "Grigio",
	fillDark: "Scuro",

	fbPlaceholder: "Valore o formula",
	fbAria: "Valore o formula della cella attiva",

	embedOpen: "Apri il foglio",
	embedMissing: "Spreadsheet Notes: file non trovato: {path}",
	embedBroken: "Spreadsheet Notes: impossibile leggere questo foglio ({message})",
	embedNoSheet: "Spreadsheet Notes: nessun foglio chiamato {name}",
	embedBadBlock:
		"Spreadsheet Notes: questo blocco richiede un percorso, per es. Budget.sheet#Sheet1!A1:D20",

	parseFailed:
		"Spreadsheet Notes: impossibile leggere questo file ({message}). Aperto in sola lettura.",
	futureVersion:
		"Spreadsheet Notes: questo file è della versione {version}, più recente di quanto il plugin comprenda. Aperto in sola lettura.",
	engineFailed: "Impossibile costruire la griglia: {message}",
	extTaken:
		"Spreadsheet Notes: l'estensione .{ext} è già registrata a {owner}. " +
		".{ext} resta a lui; i nuovi fogli saranno creati come .{fallback} e si apriranno nella stessa griglia.",
	ownerUnknown: "un altro plugin",
	ownerNamed: "il plugin «{name}» (view «{type}»)",
	ownerViewOnly: "il plugin la cui view si chiama «{type}»",

	/* 1.3.0: sort, filters, frozen panes, find, column width */
	tbSort: "Ordina",
	tbFilter: "Filtra",
	tbFreeze: "Blocca riquadri",
	tbFind: "Trova",
	tbColWidth: "Larghezza colonna",
	sortAsc: "Ordina A → Z",
	sortDesc: "Ordina Z → A",
	sortClear: "Rimuovi l'ordinamento",
	sortMerged: "Spreadsheet Notes: un foglio con celle unite non può essere ordinato.",
	sortFormulasMoved: "Sono state spostate righe con formule. I riferimenti non sono stati adattati.",
	sortNeedsCell: "Seleziona una cella nella colonna da ordinare.",
	filterShowAll: "Mostra tutto",
	filterClearAll: "Rimuovi tutti i filtri",
	filterTruncated: "Solo i primi {count} valori",
	filterNoValues: "Questa colonna è vuota, non c'è nulla da filtrare.",
	filterHiddenRows: "{count} righe nascoste dai filtri",
	freezeRows: "Blocca le righe sopra la selezione",
	freezeCols: "Blocca le colonne a sinistra della selezione",
	freezeBoth: "Blocca righe e colonne",
	freezeNone: "Sblocca i riquadri",

	/* in-sheet search */
	findPlaceholder: "Cerca nel foglio",
	findPrev: "Risultato precedente",
	findNext: "Risultato successivo",
	findClose: "Chiudi",
	findCount: "{index} di {total}",
	findNone: "Nessun risultato",

	/* column width dialog */
	colWidthTitle: "Larghezza colonna",
	colWidthLabel: "Larghezza in pixel",
	colWidthColumns: "Si applica a: {list}",
	colWidthApply: "Applica",
	colWidthAutofit: "Adatta al contenuto",
	colWidthCancel: "Annulla",

	/* markdown interop + notices */
	mdCopied: "{rows}×{cols} celle copiate come tabella Markdown",
	mdNoSelection: "Seleziona prima le celle da copiare.",
	mdPasted: "Tabella Markdown incollata, {rows}×{cols}",
	mdNoTable: "Negli appunti non c'è una tabella Markdown.",
	clipboardFailed: "Impossibile accedere agli appunti ({message})",
	sheetReadOnly: "Questo foglio è aperto in sola lettura.",
};

const PL: Record<StringKey, string> = {
	tbBold: "Pogrubienie",
	tbFontSize: "Rozmiar czcionki",
	tbFill: "Wypełnienie komórki",
	tbBorders: "Krawędzie komórki",
	tbNumberFormat: "Format liczby",
	tbAlign: "Wyrównanie",
	tbWrap: "Zawijaj tekst",
	sizeDefault: "Domyślny",
	borderAll: "Wszystkie krawędzie",
	borderOutline: "Krawędzie zewnętrzne",
	borderNone: "Bez krawędzi",
	borderTop: "Góra",
	borderRight: "Prawa",
	borderBottom: "Dół",
	borderLeft: "Lewa",

	nfAuto: "Auto",
	nfTwoDecimals: "0.00",
	nfThousands: "#,##0",
	nfThousands2: "#,##0.00",
	nfPercent: "0%",
	nfUsd: "Waluta $",
	nfEur: "Waluta €",
	nfRub: "Waluta ₽",
	nfDate: "Data (yyyy-mm-dd)",
	nfDateTime: "Data i godzina",

	alignLeft: "Do lewej",
	alignCenter: "Do środka",
	alignRight: "Do prawej",
	alignTop: "Do góry",
	alignMiddleDefault: "Do środka w pionie (domyślnie)",
	alignBottom: "Do dołu",

	fillNone: "Bez wypełnienia",
	fillWhite: "Biały",
	fillYellow: "Żółty",
	fillOrange: "Pomarańczowy",
	fillRed: "Czerwony",
	fillPink: "Różowy",
	fillGreen: "Zielony",
	fillTeal: "Turkusowy",
	fillBlue: "Niebieski",
	fillPurple: "Purpurowy",
	fillGrey: "Szary",
	fillDark: "Ciemny",

	fbPlaceholder: "Wartość lub formuła",
	fbAria: "Wartość lub formuła aktywnej komórki",

	embedOpen: "Otwórz arkusz",
	embedMissing: "Spreadsheet Notes: nie ma takiego pliku: {path}",
	embedBroken: "Spreadsheet Notes: nie udało się odczytać tego arkusza ({message})",
	embedNoSheet: "Spreadsheet Notes: brak arkusza o nazwie {name}",
	embedBadBlock:
		"Spreadsheet Notes: ten blok potrzebuje ścieżki, np. Budget.sheet#Sheet1!A1:D20",

	parseFailed:
		"Spreadsheet Notes: nie udało się odczytać tego pliku ({message}). Otwarto tylko do odczytu.",
	futureVersion:
		"Spreadsheet Notes: ten plik ma wersję {version}, nowszą niż rozumie wtyczka. Otwarto tylko do odczytu.",
	engineFailed: "Nie udało się zbudować siatki: {message}",
	extTaken:
		"Spreadsheet Notes: rozszerzenie .{ext} jest już zarejestrowane przez {owner}. " +
		".{ext} zostaje przy nim; nowe arkusze będą tworzone jako .{fallback} i otworzą się w tej samej siatce.",
	ownerUnknown: "inną wtyczkę",
	ownerNamed: "wtyczkę „{name}” (view „{type}”)",
	ownerViewOnly: "wtyczkę, której view nazywa się „{type}”",

	/* 1.3.0: sort, filters, frozen panes, find, column width */
	tbSort: "Sortuj",
	tbFilter: "Filtruj",
	tbFreeze: "Zablokuj okienka",
	tbFind: "Znajdź",
	tbColWidth: "Szerokość kolumny",
	sortAsc: "Sortuj A → Z",
	sortDesc: "Sortuj Z → A",
	sortClear: "Usuń sortowanie",
	sortMerged: "Spreadsheet Notes: arkusza ze scalonymi komórkami nie można posortować.",
	sortFormulasMoved: "Przeniesiono wiersze z formułami. Odwołania w formułach nie zostały dostosowane.",
	sortNeedsCell: "Zaznacz komórkę w kolumnie, którą chcesz posortować.",
	filterShowAll: "Pokaż wszystko",
	filterClearAll: "Wyczyść wszystkie filtry",
	filterTruncated: "Tylko pierwsze {count} wartości",
	filterNoValues: "Ta kolumna jest pusta, nie ma czego filtrować.",
	filterHiddenRows: "Filtry ukrywają wiersze: {count}",
	freezeRows: "Zablokuj wiersze powyżej zaznaczenia",
	freezeCols: "Zablokuj kolumny na lewo od zaznaczenia",
	freezeBoth: "Zablokuj wiersze i kolumny",
	freezeNone: "Odblokuj okienka",

	/* in-sheet search */
	findPlaceholder: "Znajdź w arkuszu",
	findPrev: "Poprzednie dopasowanie",
	findNext: "Następne dopasowanie",
	findClose: "Zamknij",
	findCount: "{index} z {total}",
	findNone: "Brak dopasowań",

	/* column width dialog */
	colWidthTitle: "Szerokość kolumny",
	colWidthLabel: "Szerokość w pikselach",
	colWidthColumns: "Dotyczy: {list}",
	colWidthApply: "Zastosuj",
	colWidthAutofit: "Dopasuj do zawartości",
	colWidthCancel: "Anuluj",

	/* markdown interop + notices */
	mdCopied: "Skopiowano komórki {rows}×{cols} jako tabelę Markdown",
	mdNoSelection: "Najpierw zaznacz komórki do skopiowania.",
	mdPasted: "Wklejono tabelę Markdown, {rows}×{cols}",
	mdNoTable: "W schowku nie ma tabeli Markdown.",
	clipboardFailed: "Brak dostępu do schowka ({message})",
	sheetReadOnly: "Ten arkusz jest otwarty tylko do odczytu.",
};

export const TABLES: Record<Lang, Record<StringKey, string>> = {
	en: EN,
	ru: RU,
	zh: ZH,
	"zh-TW": ZH_TW,
	de: DE,
	fr: FR,
	es: ES,
	ja: JA,
	ko: KO,
	"pt-BR": PT_BR,
	it: IT,
	pl: PL,
};

/**
 * Codes that must NOT be resolved by their bare language.
 *
 * Traditional Chinese is a different table from Simplified, and Obsidian spells
 * it `zh-TW`; the script tags are what other apps send. Portuguese has one
 * table here (Brazilian), so European Portuguese maps to it rather than to
 * English, which would be a worse answer.
 */
const EXACT: Record<string, Lang> = {
	"zh-tw": "zh-TW",
	"zh-hant": "zh-TW",
	"zh-hk": "zh-TW",
	"zh-mo": "zh-TW",
	"zh-hans": "zh",
	"zh-cn": "zh",
	"pt-br": "pt-BR",
	pt: "pt-BR",
};

/** Bare language codes that have a table under the same name. */
const BASE = new Set<string>(["en", "ru", "zh", "de", "fr", "es", "ja", "ko", "it", "pl"]);

/** "ru-RU" -> ru, "zh-TW" -> zh-TW, "pt" -> pt-BR, anything unknown -> en. */
export function pickLang(raw: unknown): Lang {
	if (typeof raw !== "string") return "en";
	const code = raw.trim().toLowerCase().replace(/_/g, "-");
	if (code.length === 0) return "en";
	const exact = EXACT[code];
	if (exact) return exact;
	const base = code.split("-")[0] ?? "";
	if (EXACT[base]) return EXACT[base] as Lang;
	return BASE.has(base) ? (base as Lang) : "en";
}

/** Read Obsidian's configured interface language. Never throws. */
export function detectLang(): Lang {
	let raw = "";
	try {
		raw = globalThis.localStorage?.getItem("language") ?? "";
	} catch {
		/* localStorage can be unavailable */
	}
	if (!raw) {
		try {
			raw =
				(globalThis as unknown as { moment?: { locale?: () => string } }).moment?.locale?.() ?? "";
		} catch {
			/* moment is Obsidian's, not ours */
		}
	}
	return pickLang(raw);
}

let override: Lang | null = null;

/** Force a language. Used by tests; also lets a future setting override it. */
export function setLang(lang: Lang | null): void {
	override = lang;
}

/**
 * Deliberately NOT cached. Obsidian's language can change while the app runs
 * (Settings -> About), and a cached value would then need an invalidation hook
 * nobody would remember to call. Detection is two property reads.
 */
export function lang(): Lang {
	return override ?? detectLang();
}

/** Interpolate `{name}` placeholders; unknown names are left as they are. */
export function fill(template: string, vars?: Record<string, string | number>): string {
	if (!vars) return template;
	return template.replace(/\{(\w+)\}/g, (m, key: string) =>
		key in vars ? String(vars[key]) : m,
	);
}

/** Translate a key, falling back to English for a missing translation. */
export function t(key: StringKey, vars?: Record<string, string | number>): string {
	const table = TABLES[lang()];
	return fill(table[key] || TABLES.en[key], vars);
}
