/**
 * The one question the touch rules ask: is this a touch interface?
 *
 * `body.is-mobile` is Obsidian's own class, and it is deliberately the signal
 * used here rather than `Platform.isMobile`:
 *
 *   - the entire theme layer is already gated on that class, so the sizing and
 *     the behaviour cannot disagree;
 *   - a DESKTOP sandbox can put the class on and get the real mobile behaviour,
 *     which is the only way the touch rules are testable at all (the e2e drives
 *     an emulated tablet inside a desktop Obsidian);
 *   - it costs no import, so the modules with unit tests of their own (the
 *     formula bar) stay free of `obsidian` and of the grid engine.
 *
 * Callers that already import `obsidian` may OR this with `Platform.isMobile`,
 * which on a real device is true at the same time.
 */
export function isTouchUi(): boolean {
	return typeof document !== "undefined" && !!document.body?.classList?.contains("is-mobile");
}
