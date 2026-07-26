/**
 * Tiny i18n layer. English is the default; Russian is used when Obsidian is set
 * to Russian.
 *
 * How the language is decided (in this order):
 *   1. `localStorage.getItem("language")` — where Obsidian keeps the interface
 *      language chosen in Settings -> About. It is empty/absent for English.
 *   2. `window.moment.locale()` — Obsidian ships moment on the global and keeps
 *      its locale in step with the interface language.
 *   3. English.
 *
 * Command names stay English regardless: Obsidian's own convention is that
 * command palette entries are not translated by plugins (they are user-visible
 * hotkey identifiers).
 *
 * Both tables are complete `Record<StringKey, string>`, so a missing Russian
 * string is a compile error, and a unit test asserts the two key sets match.
 */

export type Lang = "en" | "ru";

const EN = {
	/* toolbar */
	tbBold: "Bold",
	tbFontSize: "Font size",
	tbFill: "Cell fill",
	tbBorders: "Cell borders",
	sizeDefault: "Default",
	borderAll: "All borders",
	borderOutline: "Outer borders",
	borderNone: "No borders",
	borderTop: "Top",
	borderRight: "Right",
	borderBottom: "Bottom",
	borderLeft: "Left",

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
} as const;

export type StringKey = keyof typeof EN;

const RU: Record<StringKey, string> = {
	tbBold: "Жирный",
	tbFontSize: "Размер шрифта",
	tbFill: "Заливка ячейки",
	tbBorders: "Границы ячеек",
	sizeDefault: "По умолчанию",
	borderAll: "Все границы",
	borderOutline: "Внешние границы",
	borderNone: "Без границ",
	borderTop: "Сверху",
	borderRight: "Справа",
	borderBottom: "Снизу",
	borderLeft: "Слева",

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
};

export const TABLES: Record<Lang, Record<StringKey, string>> = { en: EN, ru: RU };

/** "ru", "ru-RU", "RU" -> ru; everything else (including "") -> en. */
export function pickLang(raw: unknown): Lang {
	return typeof raw === "string" && raw.toLowerCase().startsWith("ru") ? "ru" : "en";
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
