/**
 * i18n unit tests. The plugin ships English by default and switches to Russian
 * when Obsidian's interface language is Russian, so the two tables have to stay
 * in lockstep and the language detection has to be un-crashable.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { TABLES, fill, lang, pickLang, setLang, t } from "./.build/i18n.mjs";

test("the two tables have exactly the same keys", () => {
	const en = Object.keys(TABLES.en).sort();
	const ru = Object.keys(TABLES.ru).sort();
	assert.deepEqual(ru, en, "ru and en key sets differ");
});

test("no string is empty and no Russian string was left untranslated", () => {
	for (const [name, table] of Object.entries(TABLES)) {
		for (const [key, value] of Object.entries(table)) {
			assert.equal(typeof value, "string", `${name}.${key}`);
			assert.ok(value.trim().length > 0, `${name}.${key} is empty`);
		}
	}
	for (const [key, value] of Object.entries(TABLES.ru)) {
		// Anything with Latin letters only and no placeholder is a copy-paste of
		// the English string. Product names are the legitimate exception.
		const stripped = value.replace(/\{\w+\}/g, "").replace(/Spreadsheet Notes|CSV|view/g, "");
		if (/[a-z]{4,}/i.test(stripped)) {
			assert.fail(`ru.${key} looks untranslated: ${value}`);
		}
	}
});

test("every placeholder in a Russian string exists in the English one", () => {
	const names = (s) => (s.match(/\{\w+\}/g) ?? []).sort();
	for (const key of Object.keys(TABLES.en)) {
		const en = new Set(names(TABLES.en[key]));
		for (const ph of names(TABLES.ru[key])) {
			assert.ok(en.has(ph), `ru.${key} uses ${ph}, en.${key} does not`);
		}
	}
});

test("English is the default, Russian needs an ru locale", () => {
	assert.equal(pickLang("ru"), "ru");
	assert.equal(pickLang("ru-RU"), "ru");
	assert.equal(pickLang("RU"), "ru");
	for (const other of ["", "en", "en-GB", "uk", "be", null, undefined, 42, {}]) {
		assert.equal(pickLang(other), "en", String(other));
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

	setLang(null);
});

test("fill leaves unknown placeholders alone instead of printing undefined", () => {
	assert.equal(fill("a {x} b {y}", { x: "1" }), "a 1 b {y}");
	assert.equal(fill("no vars"), "no vars");
});
