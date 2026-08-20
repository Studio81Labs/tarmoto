import type { CatalogsByLocale } from "@tarmoto/shared";
import { pseudoLocalizeCatalog } from "../pseudo";
import { en, type EnglishMessageKey } from "./en";

// =============================================================================
// Companion UI message catalogs.
//
// To add a language: create a sibling `./<locale>.ts`, import it, and add it
// here only after it covers every English source key. The engine supports
// partial fallback for development, but the catalog coverage test prevents a
// partially translated locale from being exposed by the production selector.
// Register the language's label in the shared `LOCALES` registry
// (@tarmoto/shared/i18n) — the completeness test in ../index.test.ts fails
// until both surface edits are made.
// =============================================================================

export type TranslationCatalog = Record<EnglishMessageKey, string>;

// Dev-gated pseudo-translation swap (#1047, see ../pseudo.ts). Locale stays
// "en" — only the VALUES served for it change, so `resolveLocale()`, the
// `SupportedLocale` union, and the production language switcher are
// untouched. The NODE_ENV comparison must stay first: `next build` inlines
// it to a constant `false`, so production bundles compile the swap (and the
// pseudo module) out regardless of the env flag, which `next.config.ts`
// bridges into client bundles so server HTML and hydration agree.
const pseudoEnabled =
  process.env.NODE_ENV !== "production" &&
  process.env.TARMOTO_I18N_PSEUDO === "1";

export const companionCatalogs: CatalogsByLocale<EnglishMessageKey> = {
  en: pseudoEnabled ? pseudoLocalizeCatalog(en) : en,
};

export { en, type EnglishMessageKey };
