/**
 * Dev-only pseudo-translation of the companion catalog (#1047).
 *
 * The typed `t()` (compiler) and the localization ESLint guard (attribute
 * props + error setters) both inspect SOURCE shapes, so a raw string label
 * map rendered as JSX children — `<span>{LABELS[key]}</span>` — is invisible
 * to each of them. The only mechanism that catches "a string that never
 * reached `t()`" regardless of shape is observing RENDERED output: swap the
 * `en` catalog for one whose values are visibly marked, then assert that key
 * chrome elements carry the marker. Copy that shows up unmarked never went
 * through the catalog.
 *
 * The swap keeps locale `"en"` — a real pseudo-locale cannot go through the
 * normal path because `resolveLocale()` maps anything outside `LOCALES` back
 * to `en`, and registering one would both un-hide the production language
 * switcher and pollute the typed `SupportedLocale` union. Only catalog
 * VALUES change; keys, `LOCALES`, and locale resolution stay untouched.
 *
 * ICU safety: every catalog value must still parse as ICU MessageFormat
 * after wrapping (messages with `values` go through `IntlMessageFormat` in
 * `makeTranslator`). The sentinels are therefore pure literal text appended
 * OUTSIDE the message — never inside `{...}` argument syntax — and contain
 * none of ICU's syntax characters (`{`, `}`, `#`, `'`), so `{placeholders}`,
 * plural/select branches, and apostrophe handling are preserved verbatim.
 * `pseudo.test.ts` proves this over the whole catalog.
 *
 * Activation lives in `./locales/index.ts` behind
 * `NODE_ENV !== "production"` + `TARMOTO_I18N_PSEUDO === "1"` (bridged into
 * client bundles by `next.config.ts`); production builds compile the swap
 * out entirely. Consumed by the Playwright suite in
 * `e2e/pseudo/pseudo-i18n.spec.ts` via `playwright.pseudo.config.ts`.
 */

// Same sentinel shape as the unit-level pseudo suites (e.g.
// RideKpiCards.pseudo.test.tsx): conspicuous, expansion-simulating, and
// never produced by real copy. The e2e suite matches on these exact glyphs;
// pseudo.test.ts pins them so a drive-by edit here fails visibly instead of
// silently blinding the smoke test.
export const PSEUDO_SENTINEL_START = "⟦ !!! ";
export const PSEUDO_SENTINEL_END = " !!! ⟧";

/** Wrap one catalog value in the pseudo sentinels, ICU syntax untouched. */
export function pseudoLocalizeMessage(message: string): string {
  return `${PSEUDO_SENTINEL_START}${message}${PSEUDO_SENTINEL_END}`;
}

/** Build a pseudo-wrapped copy of a catalog. The source is not mutated. */
export function pseudoLocalizeCatalog<K extends string>(
  catalog: Readonly<Record<K, string>>,
): Record<K, string> {
  return Object.fromEntries(
    (Object.entries(catalog) as [K, string][]).map(([key, value]) => [
      key,
      pseudoLocalizeMessage(value),
    ]),
  ) as Record<K, string>;
}
