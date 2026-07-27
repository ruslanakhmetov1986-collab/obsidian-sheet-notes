/**
 * i18n unit tests. The plugin ships English plus eleven translations and follows
 * Obsidian's own interface language, so every table has to stay in lockstep with
 * the English one and the language detection has to be un-crashable.
 *
 * The tables are typed `Record<StringKey, string>`, so a MISSING key is already
 * a compile error. What the compiler cannot see is a table that was copied and
 * never translated, or a placeholder that was renamed in one language only.
 * That is what the tests below are for, and they iterate over all locales.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { LANGS, TABLES, fill, lang, pickLang, setLang, t } from "./.build/i18n.mjs";

/** Locales whose script is not Latin: an English word there is a leftover. */
const NON_LATIN = ["ru", "zh", "zh-TW", "ja", "ko"];

/**
 * Fragments that legitimately stay English in every language: the product name,
 * the Obsidian API terms the notices quote, the file extensions, and the number
 * masks (`0.00`, `yyyy-mm-dd` and friends ARE the label).
 */
const ALLOWED = [
	/Spreadsheet Notes/g,
	/Budget\.sheet#Sheet1!A1:D20/g,
	/\bview\b/g,
	/\bCSV\b/g,
	// "Markdown" is the name of the format, exactly like CSV: it is not
	// translated in Obsidian's own interface either.
	/\bMarkdown\b/g,
	// ...and so is ".xlsx", which is a file extension in every language.
	/\bxlsx\b/gi,
	// "Excel" is a product name, and it is the one Microsoft itself keeps in the
	// Russian, Chinese, Japanese and Korean interfaces ("Книга Excel").
	/\bExcel\b/g,
	/yyyy|mm|dd|hh/g,
	/\{\w+\}/g,
];

test("every shipped locale has a table and vice versa", () => {
	assert.deepEqual(Object.keys(TABLES).sort(), [...LANGS].sort());
	assert.equal(LANGS.length, 12, "the release ships twelve languages");
	assert.ok(LANGS.includes("en"));
});

test("all tables have exactly the same keys as English", () => {
	const en = Object.keys(TABLES.en).sort();
	for (const code of LANGS) {
		assert.deepEqual(Object.keys(TABLES[code]).sort(), en, `${code} key set differs`);
	}
});

test("no string is empty anywhere", () => {
	for (const code of LANGS) {
		for (const [key, value] of Object.entries(TABLES[code])) {
			assert.equal(typeof value, "string", `${code}.${key}`);
			assert.ok(value.trim().length > 0, `${code}.${key} is empty`);
		}
	}
});

test("non-Latin locales contain no leftover English", () => {
	for (const code of NON_LATIN) {
		for (const [key, value] of Object.entries(TABLES[code])) {
			let stripped = value;
			for (const re of ALLOWED) stripped = stripped.replace(re, "");
			if (/[a-z]{4,}/i.test(stripped)) {
				assert.fail(`${code}.${key} looks untranslated: ${value}`);
			}
		}
	}
});

test("every locale really is a translation, not a copy of English", () => {
	// The mask-shaped labels ("0.00", "#,##0") are identical everywhere by
	// design, so the bar is a share of the keys rather than all of them.
	for (const code of LANGS) {
		if (code === "en") continue;
		const keys = Object.keys(TABLES.en);
		const translated = keys.filter((k) => TABLES[code][k] !== TABLES.en[k]);
		const share = translated.length / keys.length;
		assert.ok(share > 0.6, `${code} differs from English in only ${translated.length}/${keys.length} strings`);
	}
});

test("every placeholder in a translation exists in the English string", () => {
	const names = (s) => (s.match(/\{\w+\}/g) ?? []).sort();
	for (const code of LANGS) {
		for (const key of Object.keys(TABLES.en)) {
			const en = new Set(names(TABLES.en[key]));
			for (const ph of names(TABLES[code][key])) {
				assert.ok(en.has(ph), `${code}.${key} uses ${ph}, en.${key} does not`);
			}
		}
	}
});

test("no translation dropped a placeholder the English string relies on", () => {
	// A notice that loses {message} or {path} is a notice that says nothing.
	const critical = ["parseFailed", "futureVersion", "engineFailed", "embedMissing", "embedBroken"];
	for (const code of LANGS) {
		for (const key of critical) {
			for (const ph of TABLES.en[key].match(/\{\w+\}/g) ?? []) {
				assert.ok(TABLES[code][key].includes(ph), `${code}.${key} lost ${ph}`);
			}
		}
	}
});

test("the .{ext} pattern survives in every extTaken string", () => {
	for (const code of LANGS) {
		const value = TABLES[code].extTaken;
		assert.ok(value.includes(".{ext}"), `${code}.extTaken lost .{ext}`);
		assert.ok(value.includes(".{fallback}"), `${code}.extTaken lost .{fallback}`);
		assert.ok(value.includes("{owner}"), `${code}.extTaken lost {owner}`);
	}
});

/* ---------------------------------------------------------------- detection */

test("English is the default and unknown languages fall back to it", () => {
	for (const other of ["", "uk", "be", "tr", "nl", "sv", "xx-YY", null, undefined, 42, {}]) {
		assert.equal(pickLang(other), "en", String(other));
	}
});

test("exact codes win over the bare language", () => {
	assert.equal(pickLang("zh-TW"), "zh-TW");
	assert.equal(pickLang("zh-tw"), "zh-TW");
	assert.equal(pickLang("zh-Hant"), "zh-TW");
	assert.equal(pickLang("zh-HK"), "zh-TW");
	assert.equal(pickLang("zh"), "zh");
	assert.equal(pickLang("zh-CN"), "zh");
	assert.equal(pickLang("zh-Hans"), "zh");
	assert.equal(pickLang("pt-BR"), "pt-BR");
	assert.equal(pickLang("pt"), "pt-BR", "we ship the Brazilian table for both");
});

test("a region suffix resolves to its language", () => {
	const cases = {
		"ru-RU": "ru",
		"de-AT": "de",
		"de_DE": "de",
		"fr-CA": "fr",
		"es-419": "es",
		"it-CH": "it",
		"pl-PL": "pl",
		"ja-JP": "ja",
		"ko-KR": "ko",
		"en-GB": "en",
		"  RU  ": "ru",
	};
	for (const [raw, expected] of Object.entries(cases)) {
		assert.equal(pickLang(raw), expected, raw);
	}
});

test("detection outside Obsidian falls back to English", () => {
	setLang(null); // force re-detection; there is no localStorage in node
	assert.equal(lang(), "en");
});

test("t() interpolates and honours the chosen language", () => {
	setLang("en");
	assert.equal(t("tbBold"), "Bold");
	assert.match(t("parseFailed", { message: "bad json" }), /bad json/);
	assert.ok(!t("parseFailed", { message: "x" }).includes("{message}"));

	setLang("ru");
	assert.equal(t("tbBold"), "Жирный");
	assert.match(t("futureVersion", { version: 9 }), /9/);

	setLang("de");
	assert.equal(t("tbBold"), "Fett");
	setLang("ja");
	assert.equal(t("tbBold"), "太字");
	setLang("zh");
	assert.equal(t("tbWrap"), "自动换行");
	setLang("zh-TW");
	assert.equal(t("tbWrap"), "自動換行");
	setLang("pt-BR");
	assert.equal(t("tbNumberFormat"), "Formato de número");

	setLang(null);
});

test("t() works for every locale and every key without throwing", () => {
	for (const code of LANGS) {
		setLang(code);
		for (const key of Object.keys(TABLES.en)) {
			const value = t(key, {
				message: "m",
				version: 2,
				path: "p",
				name: "n",
				type: "v",
				ext: "sheet",
				fallback: "lsheet",
				owner: "o",
				count: 3,
				rows: 2,
				cols: 4,
				list: "A, B",
				index: 1,
				total: 5,
				sheets: 2,
				cells: 17,
			});
			assert.ok(value.length > 0, `${code}.${key} rendered empty`);
			assert.ok(!/\{\w+\}/.test(value), `${code}.${key} left a placeholder: ${value}`);
		}
	}
	setLang(null);
});

test("fill leaves unknown placeholders alone instead of printing undefined", () => {
	assert.equal(fill("a {x} b {y}", { x: "1" }), "a 1 b {y}");
	assert.equal(fill("no vars"), "no vars");
});
